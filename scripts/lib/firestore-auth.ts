import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const BLOCKED_WRITER_EMAILS = new Set([
  "planningmsku@hellofresh-de-problem-solve.iam.gserviceaccount.com",
  "pdl-fast-reader@hellofresh-de-problem-solve.iam.gserviceaccount.com",
]);

function tryReadClientEmail(jsonPath: string): string | null {
  try {
    const raw = readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { client_email?: string };
    return parsed.client_email ?? null;
  } catch {
    return null;
  }
}

function assertAllowedWriterEmail(email: string | null, source: string) {
  if (!email) return;
  const normalized = email.trim().toLowerCase();
  const allowReaderAsWriter = process.env.FIRESTORE_ALLOW_READER_AS_WRITER === "1";
  if (BLOCKED_WRITER_EMAILS.has(normalized) && !allowReaderAsWriter) {
    throw new Error(
      `Unsicherer Firestore-Writer erkannt (${normalized}) aus ${source}. ` +
      "Bitte dedizierten Writer-Service-Account nutzen (FIRESTORE_WRITER_CREDENTIALS). " +
      "Nur fuer Ausnahmefaelle kann FIRESTORE_ALLOW_READER_AS_WRITER=1 gesetzt werden."
    );
  }
}

export function configureFirestoreWriterAuth() {
  const explicitWriter = (process.env.FIRESTORE_WRITER_CREDENTIALS ?? "").trim();
  const existingCreds = (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
  const allowAdcFallback = process.env.FIRESTORE_USE_GCLOUD_ADC !== "0";

  if (explicitWriter) {
    const writerPath = resolve(explicitWriter);
    if (!existsSync(writerPath)) {
      throw new Error(`FIRESTORE_WRITER_CREDENTIALS nicht gefunden: ${writerPath}`);
    }
    process.env.GOOGLE_APPLICATION_CREDENTIALS = writerPath;
    const email = tryReadClientEmail(writerPath);
    assertAllowedWriterEmail(email, "FIRESTORE_WRITER_CREDENTIALS");
    console.log(`Firestore-Writer-Credentials: ${writerPath}${email ? ` (${email})` : ""}`);
    return;
  }

  if (existingCreds) {
    const resolvedExisting = resolve(existingCreds);
    if (!existsSync(resolvedExisting)) {
      throw new Error(`GOOGLE_APPLICATION_CREDENTIALS nicht gefunden: ${resolvedExisting}`);
    }
    process.env.GOOGLE_APPLICATION_CREDENTIALS = resolvedExisting;
    const email = tryReadClientEmail(resolvedExisting);
    assertAllowedWriterEmail(email, "GOOGLE_APPLICATION_CREDENTIALS");
    console.log(`Firestore-Write via GOOGLE_APPLICATION_CREDENTIALS: ${resolvedExisting}${email ? ` (${email})` : ""}`);
    return;
  }

  if (allowAdcFallback) {
    const appData = process.env.APPDATA;
    const adcPath = appData ? resolve(appData, "gcloud", "application_default_credentials.json") : "";
    if (adcPath && existsSync(adcPath)) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
      console.log(`Firestore-Write via gcloud ADC Fallback: ${adcPath}`);
      return;
    }
  }

  console.warn("Keine Firestore-Write-Credentials gefunden (FIRESTORE_WRITER_CREDENTIALS/GOOGLE_APPLICATION_CREDENTIALS/ADC).");
}
