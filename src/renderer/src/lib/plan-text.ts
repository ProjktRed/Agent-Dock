/** Phases ("## Phase N") and checkbox tasks ("- [ ]") in a plan being edited; Save needs at least one of each. */
export function planCounts(text: string): { phases: number; tasks: number } {
  return {
    phases: (text.match(/^##\s+Phase\s+\d+/gim) ?? []).length,
    tasks: (text.match(/^\s*-\s+\[[ xX]\]\s+/gm) ?? []).length,
  };
}
