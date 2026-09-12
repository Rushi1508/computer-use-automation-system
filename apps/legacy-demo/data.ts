/**
 * Synthetic data for the demo core-banking surface.
 *
 * Everything here is invented. No real member data, no real institution, and
 * no real account numbers — the brief forbids real credentials or PII, and a
 * demo target is exactly where that rule is easiest to violate by accident.
 *
 * Money is stored in integer cents. Float dollars would introduce rounding
 * drift that the replay engine's checkpoint assertions would then have to
 * tolerate, which would muddy a real signal (a wrong balance) with a fake one.
 */

export type MemberStatus = "active" | "restricted" | "closed";

export interface Account {
  readonly number: string;
  readonly type: "Checking" | "Savings" | "Money Market" | "Certificate";
  readonly balanceCents: number;
  readonly openedOn: string;
}

export interface Member {
  readonly id: string;
  readonly name: string;
  readonly status: MemberStatus;
  readonly branch: string;
  readonly joinedOn: string;
  readonly accounts: readonly Account[];
}

const MEMBERS: readonly Member[] = [
  {
    id: "12345",
    name: "Dolores Abernathy",
    status: "active",
    branch: "Westworld Main",
    joinedOn: "2019-03-14",
    accounts: [
      { number: "0001-4472", type: "Checking", balanceCents: 248_15, openedOn: "2019-03-14" },
      { number: "0002-8891", type: "Savings", balanceCents: 14_820_37, openedOn: "2019-03-14" },
      { number: "0004-1120", type: "Certificate", balanceCents: 25_000_00, openedOn: "2022-11-02" },
    ],
  },
  {
    id: "23456",
    name: "Bernard Lowe",
    status: "active",
    branch: "Mesa Hub",
    joinedOn: "2021-07-30",
    accounts: [
      { number: "0001-9930", type: "Checking", balanceCents: 1_902_44, openedOn: "2021-07-30" },
    ],
  },
  {
    id: "34567",
    name: "Maeve Millay",
    status: "active",
    branch: "Westworld Main",
    joinedOn: "2017-01-09",
    accounts: [
      { number: "0001-2245", type: "Checking", balanceCents: 7_413_08, openedOn: "2017-01-09" },
      { number: "0002-6610", type: "Savings", balanceCents: 63_119_92, openedOn: "2018-05-21" },
    ],
  },
  {
    // Exercises the PERMISSION_DENIED business outcome: the record exists, but
    // this operator's role cannot view it. Distinct from "not found" — the
    // caller needs to tell those apart, which is the whole point of the
    // business-outcome vs failure split in the replay result contract.
    id: "55555",
    name: "Charlotte Hale",
    status: "restricted",
    branch: "Executive",
    joinedOn: "2015-02-02",
    accounts: [
      { number: "0001-0001", type: "Money Market", balanceCents: 1_500_000_00, openedOn: "2015-02-02" },
    ],
  },
  {
    id: "67890",
    name: "Teddy Flood",
    status: "closed",
    branch: "Mesa Hub",
    joinedOn: "2016-08-17",
    accounts: [],
  },
];

const BY_ID = new Map(MEMBERS.map((m) => [m.id, m]));

export function findMember(id: string): Member | undefined {
  return BY_ID.get(id.trim());
}

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const remainder = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${remainder}`;
}

/** Sub-accounts opened during a session. In-memory only; reset with the process. */
const OPENED: Array<{ memberId: string; accountNumber: string; type: string; depositCents: number }> = [];

export function openSubAccount(memberId: string, type: string, depositCents: number): string {
  const accountNumber = `0009-${String(4000 + OPENED.length).padStart(4, "0")}`;
  OPENED.push({ memberId, accountNumber, type, depositCents });
  return accountNumber;
}

export function resetOpenedAccounts(): void {
  OPENED.length = 0;
}
