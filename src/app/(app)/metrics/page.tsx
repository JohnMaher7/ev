import dynamic from "next/dynamic";

import { AppLayout } from "@/components/layout/app-layout";

const MetricsView = dynamic(() => import("@/components/views/metrics-view"), {
  loading: () => <div className="h-64" aria-busy="true" />,
});

export default function MetricsPage() {
  return (
    <AppLayout title="Performance" description="System-level KPIs and margins">
      <MetricsView />
    </AppLayout>
  );
}


