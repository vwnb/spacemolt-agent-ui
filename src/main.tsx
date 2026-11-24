import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import App from "./App";

function frontendApiFromKey(key: string): string {
  const encoded = key.replace(/^pk_(test|live)_/, "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return atob(padded).replace(/\$$/, "");
  } catch {
    return "";
  }
}

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const frontendApi = publishableKey?.startsWith("pk_live_")
  ? frontendApiFromKey(publishableKey)
  : "";
const clerkProxyUrl =
  import.meta.env.VITE_CLERK_PROXY_URL ||
  (frontendApi ? `https://${frontendApi}` : "");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {publishableKey ? (
      <ClerkProvider publishableKey={publishableKey} proxyUrl={clerkProxyUrl}>
        <App />
      </ClerkProvider>
    ) : (
      <p style={{ fontFamily: "system-ui", padding: "2rem" }}>
        Set VITE_CLERK_PUBLISHABLE_KEY in .env.local to continue.
      </p>
    )}
  </StrictMode>,
);
