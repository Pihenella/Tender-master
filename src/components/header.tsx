"use client";

type ProfileId = "boltinov" | "pikhenek";

const PROFILE_LABELS: Record<ProfileId, string> = {
  boltinov: "ИП Болтинов",
  pikhenek: "ИП Пихенек",
};

interface HeaderProps {
  profileId: ProfileId;
  onProfileChange: (id: ProfileId) => void;
}

export function Header({ profileId, onProfileChange }: HeaderProps) {
  return (
    <header className="border-b bg-white px-6 py-3 flex items-center justify-between">
      <h1 className="text-xl font-bold">Tender-Master</h1>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Профиль:</span>
        <select
          value={profileId}
          onChange={(e) => onProfileChange(e.target.value as ProfileId)}
          className="border rounded px-3 py-1.5 text-sm"
        >
          {Object.entries(PROFILE_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </div>
    </header>
  );
}
