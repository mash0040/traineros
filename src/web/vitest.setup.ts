import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library registers this itself only when Vitest globals are on. They are off here
// (tests import what they use), so unmounting is wired up explicitly. Without it, renders
// pile up in one document and queries start matching the previous test's markup.
afterEach(cleanup)
