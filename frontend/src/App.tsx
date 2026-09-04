import { Navigate, Route, Routes } from "react-router-dom";

import { AppLayout } from "@/components/AppLayout";
import { CenterSpinner } from "@/components/ui/Page";
import { useMe } from "@/hooks/useAuth";
import { Login } from "@/pages/Login";
import { Logs } from "@/pages/Logs";
import { ManualUpload } from "@/pages/ManualUpload";
import { Overview } from "@/pages/Overview";
import { Queue } from "@/pages/Queue";
import { Vods } from "@/pages/Vods";
import { WatchVod } from "@/pages/WatchVod";
import { YouTube } from "@/pages/YouTube";

function Protected({ children }: { children: React.ReactNode }) {
  const { data, isLoading, isError } = useMe();
  if (isLoading) {
    return (
      <div className="grid h-dvh place-items-center">
        <CenterSpinner />
      </div>
    );
  }
  if (isError || !data) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <Protected>
            <AppLayout />
          </Protected>
        }
      >
        <Route path="/" element={<Overview />} />
        <Route path="/vods" element={<Vods />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/upload" element={<ManualUpload />} />
        <Route path="/watch" element={<WatchVod />} />
        <Route path="/youtube" element={<YouTube />} />
        <Route path="/logs" element={<Logs />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
