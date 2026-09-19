import { editionSchedulePatch } from "../functions/_shared/schedule.ts";
function assert(v: unknown, message = "Assertion failed"): asserts v { if (!v) throw new Error(message); }
Deno.test("edition schedules accept selected weekdays and normalize time", () => {
  const p=editionSchedulePatch({delivery_days:[5,1,3],delivery_time:"07:30",enabled:false});
  assert(JSON.stringify(p.delivery_days)==="[1,3,5]" && p.delivery_time==="07:30:00" && p.enabled===false);
  assert(Object.keys(editionSchedulePatch({name:"Reading",schedule_version:99})).length===0);
});
Deno.test("edition schedules reject invalid days, times, and coerced toggles", () => {
  for(const body of [{delivery_days:[]},{delivery_days:[1,1]},{delivery_days:[7]},{delivery_days:[null]},{delivery_days:["1"]},{delivery_time:"24:00"},{delivery_time:"12:61"},{delivery_time:"12:00:30"},{enabled:"false"}]) {
    let rejected=false;try{editionSchedulePatch(body)}catch(e){rejected=(e as any).status===400}assert(rejected,JSON.stringify(body));
  }
});
