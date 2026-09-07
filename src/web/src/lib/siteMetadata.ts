export const SITE = {
  name: 'TrainerOS',
  title: 'TrainerOS | Workout Programming and Logging',
  description:
    'Mobile workout programming, reminders, and set logging for a personal trainer and their clients.',
  canonicalUrl: 'https://traineros.me/',
  themeColor: '#D07000',
  backgroundColor: '#FCFCFD',
  locale: 'en_CA',
} as const

export function pageTitle(page: string): string {
  return `${page} | ${SITE.name}`
}
