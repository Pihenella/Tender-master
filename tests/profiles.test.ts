import { describe, it, expect } from "vitest";
import { profiles, getProfile } from "../src/lib/profiles";

describe("profiles", () => {
  it("has two profiles", () => {
    expect(Object.keys(profiles)).toHaveLength(2);
    expect(profiles.boltinov).toBeDefined();
    expect(profiles.pikhenek).toBeDefined();
  });

  it("each profile has required fields", () => {
    for (const profile of Object.values(profiles)) {
      expect(profile.fullName).toBeTruthy();
      expect(profile.inn).toBeTruthy();
      expect(profile.ogrn).toBeTruthy();
      expect(profile.bank.name).toBeTruthy();
      expect(profile.bank.bic).toBeTruthy();
      expect(profile.director.fio).toBeTruthy();
    }
  });

  it("getProfile returns correct profile", () => {
    expect(getProfile("boltinov").inn).toBe(profiles.boltinov.inn);
    expect(getProfile("pikhenek").inn).toBe(profiles.pikhenek.inn);
  });
});
