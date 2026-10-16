import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import App from "./App";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root container missing");

const root = createRoot(container);
const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;

/**
 * The same bundle powers two products: the hosted cloud assistant (accounts,
 * chat history, notes, reminders) and the offline desktop console. When the
 * build has no Convex URL the cloud routes explain themselves, but the landing
 * page and the local console keep working — nothing mounts a Convex hook
 * without a provider.
 */
root.render(
  <StrictMode>
    {convexUrl ? (
      <ConvexAuthProvider client={new ConvexReactClient(convexUrl)}>
        <App cloudReady />
      </ConvexAuthProvider>
    ) : (
      <App cloudReady={false} />
    )}
  </StrictMode>,
);
