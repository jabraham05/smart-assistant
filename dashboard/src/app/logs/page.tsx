import { LogViewer } from "@/components/logs/LogViewer";

export default function LogsPage() {
  return (
    <div>
      <h1 className="mb-3 text-lg font-semibold">Logs</h1>
      <LogViewer />
    </div>
  );
}
