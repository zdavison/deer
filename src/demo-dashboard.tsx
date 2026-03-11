import React from "react";
import Dashboard from "./dashboard.tsx";
import { MOCK_AGENTS } from "./mock-agents.ts";

export default function DemoDashboard() {
  return <Dashboard cwd={process.cwd()} mockAgents={MOCK_AGENTS} />;
}
