"use client";

import Link from "next/link";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { StatusBadge } from "./status-badge";
import type { Id } from "../../convex/_generated/dataModel";

interface ProcurementCardProps {
  id: Id<"procurements">;
  number: string;
  name: string;
  nmck: number;
  status: string;
  createdAt: number;
}

export function ProcurementCard({
  id,
  number,
  name,
  nmck,
  status,
  createdAt,
}: ProcurementCardProps) {
  const remove = useMutation(api.procurements.remove);

  return (
    <div className="bg-white rounded-lg border p-4 hover:shadow-md transition-shadow">
      <Link href={`/procurement/${id}`} className="block">
        <div className="flex items-start justify-between mb-2">
          <div>
            <h3 className="font-semibold text-sm">
              {name || "Новая закупка"}
            </h3>
            {number && (
              <p className="text-xs text-muted-foreground mt-0.5">
                № {number}
              </p>
            )}
          </div>
          <StatusBadge status={status} />
        </div>
        {nmck > 0 && (
          <p className="text-sm text-muted-foreground">
            НМЦК: {nmck.toLocaleString("ru-RU")} ₽
          </p>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {new Date(createdAt).toLocaleDateString("ru-RU")}
        </p>
      </Link>
      <button
        onClick={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (confirm("Удалить закупку и все связанные файлы?")) {
            try {
              await remove({ id });
            } catch (err) {
              alert("Ошибка удаления: " + (err as Error).message);
            }
          }
        }}
        className="mt-2 text-xs text-red-500 hover:text-red-700"
      >
        Удалить
      </button>
    </div>
  );
}
