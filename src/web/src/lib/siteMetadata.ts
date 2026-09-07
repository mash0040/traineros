export const SITE = {
  name: 'TrainerOS',
  title: 'TrainerOS | Workout Programming and Logging',
  description:
    'TrainerOS helps a personal trainer program workouts, send reminders, and let clients log sets from a mobile-first workout workspace.',
  canonicalUrl: 'https://traineros.me/',
  themeColor: '#D07000',
  backgroundColor: '#FCFCFD',
  locale: 'en_CA',
} as const

export function pageTitle(page: string): string {
  return `${page} | ${SITE.name}`
}
