import React from 'react';
import { ShieldQuestion } from 'lucide-react';
import { ViewLayout } from '../components/layout/ViewLayout';
import { EmptyState } from '../components/ui/EmptyState';

/**
 * Indicator Matches while indicator checks are unavailable (EPOCH-489). They
 * came from a tool the project no longer uses; its own matching on its
 * extracted facts returns with EPOCH-490 to 493. The page says so plainly for
 * every investigation, so an empty page is never read as a clean device.
 */
export const IocsView: React.FC = () => (
  <ViewLayout section="iocs" title="Indicator Matches">
    <EmptyState
      icon={ShieldQuestion}
      title="Indicator checks are not available yet"
      detail="Indicator matching is being rebuilt on the facts Verichron extracts. Until it returns, no investigation is checked against indicators of compromise: an empty page here means nothing was checked, not that the device is clean."
    />
  </ViewLayout>
);
