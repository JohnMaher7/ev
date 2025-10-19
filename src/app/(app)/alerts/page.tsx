import dynamic from "next/dynamic";

import { AppLayout } from "@/components/layout/app-layout";

const AlertsView = dynamic(() => import("@/components/views/alerts-view"), {
  loading: () => <div className="h-64" aria-busy="true" />,
});

export default function AlertsPage() {
  return (
    <AppLayout title="Alerts" description="All current value opportunities">
      <AlertsView />
    </AppLayout>
  );
}


