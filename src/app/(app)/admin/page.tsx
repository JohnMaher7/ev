import dynamic from "next/dynamic";

import { AppLayout } from "@/components/layout/app-layout";

const AdminView = dynamic(() => import("@/components/views/admin-view"), {
  loading: () => <div className="h-64" aria-busy="true" />,
});

export default function AdminPage() {
  return (
    <AppLayout title="Operations" description="System orchestration and health">
      <AdminView />
    </AppLayout>
  );
}


