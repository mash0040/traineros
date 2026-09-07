import { useEffect } from 'react'

import { pageTitle } from '../lib/siteMetadata'

export function PageTitle({ title }: { title: string }) {
  useEffect(() => {
    document.title = pageTitle(title)
  }, [title])

  return null
}
