import type { ResponseEnvelope } from "@design-studio/contracts";
export async function writeOutput(envelope: ResponseEnvelope, json: boolean) {
  const text = json
    ? `${JSON.stringify(envelope)}\n`
    : envelope.success
      ? `${JSON.stringify(envelope.data, null, 2)}\n`
      : `${envelope.error.code}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}
