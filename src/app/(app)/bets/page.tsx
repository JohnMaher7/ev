import dynamic from "next/dynamic";

import { AppLayout } from "@/components/layout/app-layout";

const BetsView = dynamic(() => import("@/components/views/bets-view"), {
  loading: () => <div className="h-64" aria-busy="true" />,
});

export default function BetsPage() {
  return (
    <AppLayout title="Bets" description="Execution log and settlement status">
      <BetsView />
    </AppLayout>
  );
}


