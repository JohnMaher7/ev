'use client';

import { useState } from 'react';
import { AlertsTable } from './alerts-table';
import { BetsTable } from './bets-table';
import { MetricsDashboard } from './metrics-dashboard';
import { AdminPanel } from './admin-panel';
import { cn } from '@/lib/utils';

type Tab = 'alerts' | 'bets' | 'metrics' | 'admin';

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('alerts');

  const tabs = [
    { id: 'alerts' as const, label: 'Alerts', icon: '🔔' },
    { id: 'bets' as const, label: 'Bets', icon: '💰' },
    { id: 'metrics' as const, label: 'Performance', icon: '📊' },
    { id: 'admin' as const, label: 'Admin', icon: '⚙️' },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <h1 className="text-xl font-semibold text-gray-900">
                EV Tennis & Soccer Scanner
              </h1>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-500">
                Europe/London
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex space-x-8">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center space-x-2 py-4 px-1 border-b-2 font-medium text-sm transition-colors',
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                )}
              >
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'alerts' && <AlertsTable />}
        {activeTab === 'bets' && <BetsTable />}
        {activeTab === 'metrics' && <MetricsDashboard />}
        {activeTab === 'admin' && <AdminPanel />}
      </main>
    </div>
  );
}
