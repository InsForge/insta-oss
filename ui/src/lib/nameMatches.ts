/** The console's type-to-confirm rule (insta-frontend confirm-delete-dialog.tsx `nameMatches`):
 *  trimmed, because the name is copied off the line above and a copy carries a trailing space;
 *  case-sensitive, because `Prod` is not `prod`; and a blank name fails closed, since a gate that
 *  opens on an empty input is a deleted resource. */
export function nameMatches(typed: string, name: string): boolean {
  if (name.trim() === '') return false
  return typed.trim() === name
}
