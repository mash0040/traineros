import type { PrescriptionView } from '../api/types.gen'

// "3 × 8-10 · 70 kg · rest 90s". Parts are dropped rather than padded with placeholders: a
// prescription with no load reads as one fewer fact, not as an empty field.
//
// Shared by Today and Log workout because DESIGN.md §Log row ranks the prescription the same
// way on both (rank 3, read once per exercise). Two copies of this would be two chances for
// the screens to disagree about what the trainer prescribed.
export function targetLine(prescription: PrescriptionView): string {
  const parts: string[] = []

  if (prescription.targetSets !== undefined && prescription.targetReps !== null) {
    parts.push(`${prescription.targetSets} × ${prescription.targetReps}`)
  }

  if (prescription.targetLoad !== null && prescription.targetLoad !== undefined && prescription.targetLoad !== '') {
    parts.push(prescription.targetLoad)
  }

  if (prescription.restSeconds !== null && prescription.restSeconds !== undefined) {
    parts.push(`rest ${prescription.restSeconds}s`)
  }

  return parts.join(' · ')
}
