// Where a deploy-time variable's value comes from.
//
// This exists because the order drifted once already: the platform resolves
// provided -> generate -> default (insta-platform resolveVariables), the local executor knew only
// provided -> generate, and the day three templates started declaring `default:` the documented
// `npm run deploy` command stopped working for all of them while the platform deployed them fine.
// One function, three call sites in deploy.mjs, and a test that replays it over the real manifests.

/**
 * @returns "provided" | "generate" | "default", or null when nothing resolves it.
 * A required variable with a null source is what stops a run; an optional one just stays unset.
 */
export function valueSource(spec, provided) {
  // Empty string counts as absent, matching the platform: a form submitted with a blank field
  // must fall through to the generator or the default rather than writing "".
  if (provided !== undefined && provided !== "") return "provided";
  if (spec?.generate) return "generate";
  if (spec?.default !== undefined) return "default";
  return null;
}

/** The variable names an entrypoint script reads, minus the ones it assigns itself. */
export function shellVarsRead(script) {
  const assigned = new Set([...script.matchAll(/^\s*([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  // ${NAME}, ${NAME:-x}, ${NAME:?x} and bare $NAME alike; uppercase only, since lower-case names
  // in these scripts are locals by convention.
  const read = [...script.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\b/g)].map((m) => m[1]);
  return [...new Set(read.filter((n) => !assigned.has(n)))];
}
