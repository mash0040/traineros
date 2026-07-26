// Writes the API's OpenAPI document to disk for openapi-ts to consume.
//
// Replaces `dotnet swagger tofile`. The Swashbuckle CLI builds its own host out of the
// compiled assembly, and its resolver cannot drive a minimal-API entry point: it falls back
// to hunting for a `Startup` class and dies with "a type named 'Startup' could not be found",
// in every environment. That failure is silent in practice, because the stale types.gen.ts it
// leaves behind still compiles. Asking the running app is both simpler and honest: the
// document served at /swagger/v1/swagger.json is the one the real app produces.
//
// The app is started from its built dll rather than through `dotnet run`, so this owns a
// single process it can reliably kill. `dotnet run` spawns the app as a grandchild, and on
// Windows killing the launcher leaves the app holding the port.

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const API_DIR = resolve(import.meta.dirname, '../../TrainerOS.Api')
const API_DLL = resolve(API_DIR, 'bin/Debug/net8.0/TrainerOS.Api.dll')
const OUTPUT = resolve(API_DIR, 'obj/openapi.json')
const STARTUP_TIMEOUT_MS = 60_000

// Port 0 lets the OS pick a free one, which is then read back from Kestrel's startup line.
// A hardcoded port would collide with the dev server the developer probably already has up.
const LISTENING = /Now listening on:\s*(http:\/\/\S+)/

function startApi() {
  const api = spawn('dotnet', [API_DLL], {
    cwd: API_DIR,
    env: {
      ...process.env,
      // Swagger is only mapped in Development, and appsettings.Development.json is where the
      // connection string and signing key live.
      ASPNETCORE_ENVIRONMENT: 'Development',
      ASPNETCORE_URLS: 'http://127.0.0.1:0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const output = []
  const origin = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`The API did not start within ${STARTUP_TIMEOUT_MS / 1000}s.\n${output.join('')}`))
    }, STARTUP_TIMEOUT_MS)

    const watch = (chunk) => {
      const text = chunk.toString()
      output.push(text)
      const match = LISTENING.exec(text)
      if (match) {
        clearTimeout(timer)
        resolvePromise(match[1])
      }
    }

    api.stdout.on('data', watch)
    api.stderr.on('data', watch)
    api.on('exit', (code) => {
      clearTimeout(timer)
      // Startup needs Postgres: TrainerSeeder runs before the host is ready. Say so, rather
      // than leaving the developer with a stack trace about a socket.
      rejectPromise(
        new Error(
          `The API exited with code ${code} before serving its OpenAPI document.\n` +
            'Is Postgres up? `docker compose up -d` starts it.\n\n' +
            output.join(''),
        ),
      )
    })
  })

  return { api, origin }
}

const { api, origin } = startApi()

try {
  const baseUrl = await origin
  const response = await fetch(new URL('/swagger/v1/swagger.json', baseUrl))
  if (!response.ok) {
    throw new Error(`GET /swagger/v1/swagger.json returned ${response.status}.`)
  }

  const document = await response.text()
  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, document)
  console.log(`Wrote ${OUTPUT} from ${baseUrl}`)
} finally {
  api.kill()
}
