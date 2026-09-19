export type PreparedDelivery = { email: { from: string; to: string[]; subject: string; text: string; attachments: any[] }; groups: any[]; feedCount: number; issues: string[]; skipReason?: string };
export type Outbox = { payload: PreparedDelivery | null; first_send_at: string | null; provider_email_id: string | null };
export class DeliveryNeedsReview extends Error {}

// Storage and provider are injected so ambiguous failures can be tested without mail.
export async function dispatchPrepared(deps: {
  load(): Promise<Outbox | null>;
  prepare(): Promise<PreparedDelivery>;
  freeze(payload: PreparedDelivery): Promise<Outbox>;
  markAttempt(at: string): Promise<void>;
  send(email: PreparedDelivery["email"]): Promise<{ id: string }>;
  record(id: string): Promise<void>;
  now?: number;
}) {
  const now = deps.now ?? Date.now();
  let outbox = await deps.load();
  if (!outbox) outbox = await deps.freeze(await deps.prepare());
  if (!outbox.payload) throw new DeliveryNeedsReview("The prepared edition has expired. Review delivery history before sending a new edition.");
  if (!outbox.payload.email.attachments.length) return { build: outbox.payload, providerId: null };
  if (outbox.provider_email_id) return { build: outbox.payload, providerId: outbox.provider_email_id };
  // Stop before the provider's 24h key expires; never blindly resend an ambiguous email.
  if (outbox.first_send_at && now - Date.parse(outbox.first_send_at) >= 23 * 3_600_000) throw new DeliveryNeedsReview("Delivery could not be confirmed within the safe retry window. Check your Kindle before creating a new send.");
  if (!outbox.first_send_at) await deps.markAttempt(new Date(now).toISOString());
  const sent = await deps.send(outbox.payload.email);
  if (!sent.id) throw new Error("The email provider did not return a delivery reference.");
  await deps.record(sent.id);
  return { build: outbox.payload, providerId: sent.id };
}

export function checkAttachmentBudget(attachments: { content: string }[]) {
  if (attachments.reduce((sum, file) => sum + file.content.length, 0) > 16_000_000) throw new Error("This edition is too large to send safely. Use fewer articles or fewer sources per send.");
}
