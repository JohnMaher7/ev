import { AppLayout } from '@/components/layout/app-layout';
import EplUnder25View from '@/components/views/epl-under25-view';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <AppLayout
      title="EPL Under 2.5 Strategy"
      description="Monitor automated back/lay trades and adjust runtime parameters."
    >
      <EplUnder25View />
    </AppLayout>
  );
}


