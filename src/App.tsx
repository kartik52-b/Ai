import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Landing from "./pages/Landing";
import AuthPage from "./pages/AuthPage";
import AssistantPage from "./pages/AssistantPage";
import DesktopApp from "./pages/DesktopApp";
import RequireAuth from "./components/RequireAuth";
import { MissingBackend } from "./components/SetupNotice";

export default function App({ cloudReady = true }: { cloudReady?: boolean }) {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/auth" element={cloudReady ? <AuthPage /> : <MissingBackend />} />
        <Route
          path="/assistant"
          element={
            cloudReady ? (
              <RequireAuth>
                <AssistantPage />
              </RequireAuth>
            ) : (
              <MissingBackend />
            )
          }
        />
        {/* Local-first console: reachable only inside the desktop shell, so it
            works offline and never asks for an account. */}
        <Route path="/desktop" element={<DesktopApp />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
