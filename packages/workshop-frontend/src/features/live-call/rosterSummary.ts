import type { CallRosterEntry } from '@gadgets/workshop-shared/api'

const NAME_LIST = new Intl.ListFormat('en', { type: 'conjunction' })

/** "No one is live yet", "Sam is live", "You and Sam are live", "Ann, Bo and 3 others are live". */
export const rosterSummary = (roster: CallRosterEntry[], currentUserId: string | null): string => {
  if (roster.length === 0) return 'No one is live yet'
  const names = roster
    .toSorted((a, b) => Number(b.profileId === currentUserId) - Number(a.profileId === currentUserId))
    .map(entry => entry.profileId === currentUserId ? 'You' : entry.name)
  const listed = names.length <= 3
    ? NAME_LIST.format(names)
    : `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`
  return `${listed} ${names.length === 1 && names[0] !== 'You' ? 'is' : 'are'} live`
}
