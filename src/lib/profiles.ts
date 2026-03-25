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
    fioShort: string;
    position: string;
    phone: string;
    email: string;
  };
  passport: {
    series: string;
    number: string;
    issueDate: string;
    issuedBy: string;
    departmentCode: string;
  };
  registration: {
    ogrnDate: string;
    ogrnRecord: string;
  };
  tax: {
    system: string;
    ndsRate: number;
    ndsLabel: string;
  };
  ownershipChain: Array<{
    fio: string;
    inn: string;
    ogrn: string;
    role: string;
    share: string;
    address: string;
    passport: string;
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
    okved: "47.91",
    legalAddress: "Республика Удмуртская город Ижевск ул., имени Сабурова А.Н. дом 47 кв. 34.",
    mailingAddress: "Республика Удмуртская город Ижевск ул., имени Сабурова А.Н. дом 47 кв. 34.",
    actualAddress: "Республика Удмуртская город Ижевск ул., имени Сабурова А.Н. дом 47 кв. 34.",
    bank: {
      name: "ООО \"Банк Точка\"",
      bic: "044525104",
      account: "40802810220000245984",
      corrAccount: "30101810745374525104",
      address: "109456, РОССИЯ, МОСКВА г. 1-Й ВЕШНЯКОВСКИЙ пр, ДОМ 1 СТР8, 1 этаж, пом.№43",
    },
    director: {
      fio: "Болтинов Данил Александрович",
      fioShort: "Болтинов Д.А.",
      position: "Индивидуальный предприниматель",
      phone: "+79193876713",
      email: "boltinov99@mail.ru",
    },
    passport: {
      series: "6519",
      number: "880947",
      issueDate: "22.05.2019",
      issuedBy: "ГУ МВД России по Свердловской области",
      departmentCode: "660-008",
    },
    registration: {
      ogrnDate: "22.02.2024",
      ogrnRecord: "324665800041636",
    },
    tax: {
      system: "УСН",
      ndsRate: 5,
      ndsLabel: "НДС 5%",
    },
    ownershipChain: [
      {
        fio: "Болтинов Данил Александрович",
        inn: "662302062065",
        ogrn: "324665800041636",
        role: "руководитель",
        share: "100%",
        address: "Республика Удмуртская город Ижевск ул., имени Сабурова А.Н. дом 47 кв. 34.",
        passport: "6519 880947",
      },
    ],
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
      address: "109456, РОССИЯ, МОСКВА г. 1-Й ВЕШНЯКОВСКИЙ пр, ДОМ 1 СТР8, 1 этаж, пом.№43",
    },
    director: {
      fio: "Пихенек Юрий Дмитриевич",
      fioShort: "Пихенек Ю.Д.",
      position: "Индивидуальный предприниматель",
      phone: "+79920027767",
      email: "rukovoditelmp@yandex.ru",
    },
    passport: {
      series: "6521",
      number: "330759",
      issueDate: "09.07.2021",
      issuedBy: "ГУ МВД России по Свердловской области",
      departmentCode: "660-006",
    },
    registration: {
      ogrnDate: "22.02.2024",
      ogrnRecord: "324665800041941",
    },
    tax: {
      system: "УСН",
      ndsRate: 5,
      ndsLabel: "НДС 5%",
    },
    ownershipChain: [
      {
        fio: "Пихенек Юрий Дмитриевич",
        inn: "662306468179",
        ogrn: "324665800041941",
        role: "руководитель",
        share: "100%",
        address: "Республика Удмуртская, р-н Завьяловский, д. Пычанки, улица Сенная, д. 32",
        passport: "6521 330759",
      },
    ],
  },
};

export function getProfile(id: "boltinov" | "pikhenek"): CompanyProfile {
  return profiles[id];
}
