"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Header } from "@/components/header";
import { ProcurementCard } from "@/components/procurement-card";

type ProfileId = "boltinov" | "pikhenek";

export default function HomePage() {
  const [profileId, setProfileId] = useState<ProfileId>("pikhenek");
  const procurements = useQuery(api.procurements.list);
  const create = useMutation(api.procurements.create);

  const handleCreate = async () => {
    await create({ profileId });
  };

  return (
    <div className="min-h-screen">
      <Header profileId={profileId} onProfileChange={setProfileId} />
      <main className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold">Закупки</h2>
          <button
            onClick={handleCreate}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700"
          >
            + Новая закупка
          </button>
        </div>

        {procurements === undefined ? (
          <p className="text-muted-foreground">Загрузка...</p>
        ) : procurements.length === 0 ? (
          <p className="text-muted-foreground text-center py-12">
            Нет закупок. Нажмите &quot;Новая закупка&quot; чтобы начать.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {procurements.map((p) => (
              <ProcurementCard
                key={p._id}
                id={p._id}
                number={p.number}
                name={p.name}
                nmck={p.nmck}
                status={p.status}
                createdAt={p._creationTime}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
