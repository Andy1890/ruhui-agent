export const fixtureSecret = "sk-test-fixture-not-a-secret";

export function readRollout(text) {
  let body = text;
  let discardedPartial = false;
  if (text.length > 0 && !text.endsWith("\n")) {
    discardedPartial = true;
    const lastNewline = text.lastIndexOf("\n");
    body = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
  }
  const events = [];
  for (const line of body.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    events.push(JSON.parse(line));
  }
  const error = validateEvents(events);
  return {
    events,
    discardedPartial,
    error,
    exitCode: error === null ? 0 : 1,
    canResume: error === null,
  };
}

export function redact(text, secret) {
  return text.split(secret).join("[redacted]");
}

export function findUnredacted(text, secret) {
  return text.includes(secret);
}

function validateEvents(events) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.schemaVersion !== 1) {
      return "schema-version";
    }
    if (event.seq !== index + 1) {
      return "seq-gap";
    }
  }
  return null;
}
