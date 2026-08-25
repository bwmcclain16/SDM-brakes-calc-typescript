/** Port of `sdm_brakes.io.export_csv`.
 *
 * The Python version wrote a pandas DataFrame to a file on disk. There is no
 * filesystem here: `rowsToCsv` returns the CSV text and the caller decides what
 * to do with it (download, clipboard, upload, ...). Quoting is the one place
 * this module can be wrong now that pandas isn't doing it — see `csvField`. */

/** Mirrors `report_filename`: `{today}_{vehicle}_{event}_{model_version}.{suffix}`.
 *
 * Uses the UTC calendar date (`Date.toISOString`) rather than the Python
 * original's local-timezone `date.today()`, since a static browser build has
 * no reliable notion of "server local time" and UTC keeps the filename
 * deterministic regardless of the viewer's timezone. */
export function reportFilename(
  vehicleName: string,
  eventName: string,
  modelVersion: string,
  suffix: string,
): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${today}_${vehicleName}_${eventName}_${modelVersion}.${suffix}`;
}

/** Quote one CSV field per RFC 4180: wrap in double quotes and double any
 * embedded double quotes whenever the value contains a comma, double quote,
 * carriage return, or line feed. `null`/`undefined` become an empty field. */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Replaces `export_dataframe_csv`. `rows` plays the role the pandas
 * DataFrame used to: an array of plain objects with the same keys, in the
 * order the solver produced them. Column order follows the first row's key
 * insertion order (all rows are expected to share that shape, same as the
 * homogeneous list-of-dict rows the Python callers built before
 * `pd.DataFrame(...)`). Returns "" for an empty array.
 *
 * Rows are newline-terminated (`\n`), including the last row. */
export function rowsToCsv(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]!);
  const lines = [columns.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => csvField(row[col])).join(","));
  }
  return lines.join("\n") + "\n";
}
