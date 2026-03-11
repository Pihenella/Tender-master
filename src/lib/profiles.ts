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
    fullName: "Индивидуальный предприниматель Болтинов Данил Александрович",
    shortName: "ИП Болтинов Д.А.",
    inn: "662302062065",
    ogrn: "324665800041636",
    okpo: "2030070106",
    kpp: "",
    oktmo: "94701000001",
    okved: "",
    legalAddress: "Республика Удмуртская, г. Ижевск, улица имени Сабурова А.Н., дом 47, кв. 34",
    mailingAddress: "Республика Удмуртская, г. Ижевск, улица имени Сабурова А.Н., дом 47, кв. 34",
    actualAddress: "Республика Удмуртская, г. Ижевск, улица имени Сабурова А.Н., дом 47, кв. 34",
    bank: {
      name: "ООО \"Банк Точка\"",
      bic: "044525104",
      account: "40802810220000245984",
      corrAccount: "30101810745374525104",
      address: "109456, Россия, г. Москва, 1-й Вешняковский пр., дом 1, стр. 8, 1 этаж, пом. №43",
    },
    director: {
      fio: "Болтинов Данил Александрович",
      position: "Индивидуальный предприниматель",
      phone: "89193876713",
      email: "boltinov99@mail.ru",
    },
    ownershipChain: [],
  },
  pikhenek: {
    id: "pikhenek",
    fullName: "Индивидуальный предприниматель Пихенек Юрий Дмитриевич",
    shortName: "ИП Пихенек Ю.Д.",
    inn: "662306468179",
    ogrn: "324665800041941",
    okpo: "2030070432",
    kpp: "",
    oktmo: "65701000001",
    okved: "47.91",
    legalAddress: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32",
    mailingAddress: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32",
    actualAddress: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32",
    bank: {
      name: "ООО \"Банк Точка\"",
      bic: "044525104",
      account: "40802810320000245978",
      corrAccount: "30101810745374525104",
      address: "109456, Россия, г. Москва, 1-й Вешняковский пр., дом 1, стр. 8, 1 этаж, пом. №43",
    },
    director: {
      fio: "Пихенек Юрий Дмитриевич",
      position: "Индивидуальный предприниматель",
      phone: "+79920027767",
      email: "rukovoditelmp@yandex.ru",
    },
    ownershipChain: [],
  },
};

export function getProfile(id: "boltinov" | "pikhenek"): CompanyProfile {
  return profiles[id];
}
