#!/usr/bin/env node
// One-off diagnostic: dump MFL's full nflByeWeeks team code list, to build an
// accurate Sleeper-standard-code -> MFL-code crosswalk (MFL uses non-standard
// 3-letter codes for a handful of teams: GB/KC/LV/NE/NO/SF/TB). Delete once
// the crosswalk is confirmed and wired into providers.mjs.

import { mflLogin, mflGet } from './lib/providers.mjs';

async function main() {
  const username = process.env.MFL_USERNAME;
  const password = process.env.MFL_PASSWORD;
  const cookie = await mflLogin(username, password);
  const data = await mflGet('/export?TYPE=nflByeWeeks&JSON=1', cookie);
  const list = data?.nflByeWeeks?.team ?? [];
  console.log(JSON.stringify(list.map((t) => t.id).sort(), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
