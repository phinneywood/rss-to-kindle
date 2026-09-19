export function editionSchedulePatch(body: Record<string, unknown>) {
  const patch: { delivery_days?: number[]; delivery_time?: string; enabled?: boolean } = {};
  const invalid = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
  if ("delivery_days" in body) {
    const days = body.delivery_days;
    if (!Array.isArray(days) || !days.length || days.length > 7 ||
      days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(days).size !== days.length) {
      invalid("Choose at least one day of the week, with no duplicates.");
    }
    patch.delivery_days = [...days as number[]].sort((a,b) => a-b);
  }
  if ("delivery_time" in body) {
    const time = body.delivery_time;
    if (typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(time)) invalid("Choose a valid delivery time.");
    patch.delivery_time = (time as string).slice(0,5) + ":00";
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") invalid("Scheduled delivery must be on or off.");
    patch.enabled = body.enabled as boolean;
  }
  return patch;
}
