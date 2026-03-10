export interface CompanyProfile {
  id: "boltinov" | "pikhenek";
  fullName: string;
  shortName: string;
  inn: string;
  ogrn: string;
  okpo: string;
  kpp: string;
  oktmo: string;
  okved: string;
  legalAddress: string;
  mailingAddress: string;
  actualAddress: string;
  bank: {
    name: string;
    bic: string;
    account: string;
    corrAccount: string;
    address: string;
  };
  director: {
    fio: string;
    position: string;
    phone: string;
    email: string;
  };
  ownershipChain: Array<{
    fio: string;
    inn: string;
    role: string;
    share: string;
    document: string;
  }>;
}

export const profiles: Record<string, CompanyProfile> = {
  boltinov: {
    id: "boltinov",
    fullName: "Индивидуальный предприниматель Болтинов",
    shortName: "ИП Болтинов",
    inn: "TODO_FILL",
    ogrn: "TODO_FILL",
    okpo: "TODO_FILL",
    kpp: "",
    oktmo: "TODO_FILL",
    okved: "TODO_FILL",
    legalAddress: "TODO_FILL",
    mailingAddress: "TODO_FILL",
    actualAddress: "TODO_FILL",
    bank: {
      name: "TODO_FILL",
      bic: "TODO_FILL",
      account: "TODO_FILL",
      corrAccount: "TODO_FILL",
      address: "TODO_FILL",
    },
    director: {
      fio: "Болтинов",
      position: "Индивидуальный предприниматель",
      phone: "TODO_FILL",
      email: "TODO_FILL",
    },
    ownershipChain: [],
  },
  pikhenek: {
    id: "pikhenek",
    fullName: "Индивидуальный предприниматель Пихенек Юрий Дмитриевич",
    shortName: "ИП Пихенек Ю.Д.",
    inn: "TODO_FILL",
    ogrn: "TODO_FILL",
    okpo: "TODO_FILL",
    kpp: "",
    oktmo: "TODO_FILL",
    okved: "47.91",
    legalAddress: "TODO_FILL",
    mailingAddress: "TODO_FILL",
    actualAddress: "TODO_FILL",
    bank: {
      name: "TODO_FILL",
      bic: "TODO_FILL",
      account: "TODO_FILL",
      corrAccount: "TODO_FILL",
      address: "TODO_FILL",
    },
    director: {
      fio: "Пихенек Юрий Дмитриевич",
      position: "Индивидуальный предприниматель",
      phone: "TODO_FILL",
      email: "TODO_FILL",
    },
    ownershipChain: [],
  },
};

export function getProfile(id: "boltinov" | "pikhenek"): CompanyProfile {
  return profiles[id];
}
