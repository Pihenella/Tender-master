const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  uploaded: { label: "Загружено", color: "bg-gray-100 text-gray-700" },
  analyzing: { label: "Анализ...", color: "bg-blue-100 text-blue-700" },
  analyzed: { label: "Калькуляция готова", color: "bg-green-100 text-green-700" },
  calculation_uploaded: {
    label: "Калькуляция загружена",
    color: "bg-orange-100 text-orange-700",
  },
  filling_forms: {
    label: "Заполнение форм...",
    color: "bg-blue-100 text-blue-700",
  },
  completed: { label: "Готово", color: "bg-emerald-100 text-emerald-700" },
  error: { label: "Ошибка", color: "bg-red-100 text-red-700" },
  pending_local_analysis: {
    label: "Ожидание локального анализа...",
    color: "bg-purple-100 text-purple-700",
  },
  pending_local_fill: {
    label: "Ожидание локального заполнения...",
    color: "bg-purple-100 text-purple-700",
  },
};

export function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || {
    label: status,
    color: "bg-gray-100",
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.color}`}
    >
      {config.label}
    </span>
  );
}
