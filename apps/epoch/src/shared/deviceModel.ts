/**
 * A device model as the examiner reads it: "iPhone 17,5" for the recorded
 * product type "iPhone17,5" (owner's review, 2026-10-19). Display only: what
 * is stored, copied for diagnosis or written to the task log keeps the
 * recorded form, so it still matches Info.plist.
 */
export function shownModel(productType: string): string {
  return productType.replace(/^([A-Za-z]+)(\d)/, '$1 $2');
}
