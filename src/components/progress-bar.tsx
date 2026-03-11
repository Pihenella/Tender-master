export function ProgressBar({
  progress,
  message,
}: {
  progress: number;
  message?: string;
}) {
  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-1">
        {message && (
          <span className="text-sm text-muted-foreground truncate mr-2">
            {message}
          </span>
        )}
        <span className="text-sm font-medium text-blue-700 shrink-0">
          {progress}%
        </span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
        <div
          className="bg-blue-600 h-2.5 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
    </div>
  );
}
