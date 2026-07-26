import { defineConfig } from '@hey-api/openapi-ts'

// Types only — no generated runtime client. DTO types come from the API's
// OpenAPI description and are never hand-duplicated (architecture.md §Stack).
//
// `output` is emptied on every run. Nothing hand-written may live in src/api: the fetch
// layer sits in src/lib/api.ts precisely because a file placed here was silently deleted the
// first time the types were regenerated.
export default defineConfig({
  input: '../TrainerOS.Api/obj/openapi.json',
  output: 'src/api',
  plugins: ['@hey-api/typescript'],
})
