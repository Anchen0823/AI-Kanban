import type { ReactNode } from 'react';
import type { PageProps } from '../App.js';
import { HistorySummary } from './HistorySummary.js';
import './quota-dashboard.css';
export function OverviewPage({ navigate, refreshToken }: PageProps): ReactNode {
  return <HistorySummary navigate={navigate} refreshToken={refreshToken} />;
}
