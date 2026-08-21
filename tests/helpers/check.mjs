/**
 * TVAgent tests — the assertion and the tally.
 *
 * Every test file had its own copy of this, which is how three of them ended
 * up printing failures in three different shapes.
 */

let failed = 0;

function stringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    // A cycle, or something JSON cannot hold. The shape is still worth seeing.
    return String(value);
  }
}

/** Deep-equality by JSON shape, which is all these tests ever compare. */
export function check(name, got, want) {
  const ok = stringify(got) === stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? ' ok  ' : ' FAIL'} ${name}` +
      (ok ? '' : `\n        got      ${stringify(got)}\n        expected ${stringify(want)}`)
  );
}

/** A section heading, so a long run reads as sections rather than one wall. */
export function section(title) {
  console.log(`\n— ${title} —`);
}

/** Call once at the end; the exit code is what a CI run reads. */
export function report() {
  console.log(failed ? `\n${failed} failed` : '\nall green');
  process.exitCode = failed ? 1 : 0;
  return failed;
}

export const failures = () => failed;
