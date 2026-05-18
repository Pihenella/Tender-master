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

export interface ParticipantProfile {
  id: string;
  type: "ip" | "ooo" | "ao" | "other";
  fullName: string;
  shortName: string;
  inn: string;
  kpp: string;
  ogrn: string;
  legalAddress: string;
  actualAddress: string;
  mailingAddress: string;
  signatory: {
    fio: string;
    fioShort: string;
    position: string;
    authorityBasis: string;
    phone: string;
    email: string;
  };
  bank: CompanyProfile["bank"];
  tax: {
    system: string;
    vatStatus: string;
    ndsRate: number;
    ndsLabel: string;
  };
  identifiers: string[];
  sourceDocuments: Array<{
    type: string;
    title: string;
    freshnessDate: string;
    available: boolean;
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
    legalAddress: "426068 Республика Удмуртская г. Ижевск улица имени Сабурова А.Н. дом 47 кв. 34.",
    mailingAddress: "426068 Республика Удмуртская г. Ижевск улица имени Сабурова А.Н. дом 47 кв. 34.",
    actualAddress: "426068 Республика Удмуртская г. Ижевск улица имени Сабурова А.Н. дом 47 кв. 34.",
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
      email: "Boltinov99@mail.ru",
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
        address: "426068 Республика Удмуртская г. Ижевск улица имени Сабурова А.Н. дом 47 кв. 34.",
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

function uniqueNonEmpty(values: Array<string | undefined | null>) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

export function adaptParticipantProfile(profile: CompanyProfile): ParticipantProfile {
  const isIp = profile.fullName.toLowerCase().includes("индивидуальный предприниматель");
  const passport = `${profile.passport.series} ${profile.passport.number}`.trim();

  return {
    id: profile.id,
    type: isIp ? "ip" : "other",
    fullName: profile.fullName,
    shortName: profile.shortName,
    inn: profile.inn,
    kpp: profile.kpp || "нет",
    ogrn: profile.ogrn,
    legalAddress: profile.legalAddress,
    actualAddress: profile.actualAddress,
    mailingAddress: profile.mailingAddress,
    signatory: {
      fio: profile.director.fio,
      fioShort: profile.director.fioShort,
      position: profile.director.position,
      authorityBasis: isIp ? "действует как индивидуальный предприниматель" : "на основании учредительных документов",
      phone: profile.director.phone,
      email: profile.director.email,
    },
    bank: profile.bank,
    tax: {
      system: profile.tax.system,
      vatStatus: profile.tax.ndsLabel,
      ndsRate: profile.tax.ndsRate,
      ndsLabel: profile.tax.ndsLabel,
    },
    identifiers: uniqueNonEmpty([
      profile.fullName,
      profile.shortName,
      profile.inn,
      profile.ogrn,
      profile.legalAddress,
      profile.actualAddress,
      profile.director.fio,
      profile.director.fioShort,
      profile.director.phone,
      profile.director.email,
      profile.bank.name,
      profile.bank.bic,
      profile.bank.account,
      profile.bank.corrAccount,
      passport,
    ]),
    sourceDocuments: [
      { type: "registration", title: "Выписка ЕГРИП/ЕГРЮЛ", freshnessDate: "", available: false },
      { type: "passport", title: "Паспортные данные подписанта", freshnessDate: profile.passport.issueDate, available: Boolean(passport) },
      { type: "tax", title: "Подтверждение налогового режима", freshnessDate: "", available: false },
      { type: "authority", title: "Основание полномочий подписанта", freshnessDate: profile.registration.ogrnDate, available: true },
    ],
  };
}

export function getParticipantProfile(id: "boltinov" | "pikhenek"): ParticipantProfile {
  return adaptParticipantProfile(getProfile(id));
}
