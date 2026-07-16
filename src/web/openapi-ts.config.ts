import { defineConfig } from '@hey-api/openapi-ts'

// Types only — no generated runtime client. DTO types come from the API's
// OpenAPI description and are never hand-duplicated (architecture.md §Stack).
export default defineConfig({
  input: '../TrainerOS.Api/obj/openapi.json',
  output: 'src/api',
  plugins: ['@hey-api/typescript'],
})
