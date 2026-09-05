/**
 * deep-workflows.js — the six-to-seven step instructions, and how to tell they were carried out.
 *
 * Kept apart from eval/workflows.js because these are DATA about the fixtures, not harness
 * logic, and they are long: each is one instruction a person would actually type, plus the
 * ordered stages that instruction implies.
 *
 * Every `test` runs inside the page after the agent stops, and two rules decide whether it is
 * a measurement or a decoration:
 *
 *   It must start FALSE on a freshly loaded page. A stage already true measures nothing and
 *   quietly inflates every score.
 *   It must check state the AGENT caused - a select moved off its first option, an input
 *   holding a value, a panel now visible - not markup the fixture always carried.
 *
 * Authored against each fixture's real ids and verified against them; see the workflow that
 * produced them for what was checked.
 */

module.exports = [
{
  key: 'shopping',
  page: 'laptop-compare.html',
  task: 'I need a new work laptop from VoltCart: run the laptop search, narrow the results to machines under \u20B970,000 with 16 GB RAM, sort what survives by customer rating, compare the shortlist and open the detail page of the best-rated one that still fits the budget, then hit Save to wishlist on it, rename the list to "Q4 dev laptops", set the price alert to 64000 and submit the save.',
  stages: [
    {
      name: 'searched',
      test: () => /^Showing \d+ of 8 results for /.test(document.getElementById('result-count').textContent)
    },
    {
      name: 'price-filtered',
      test: () => ['0-70000', '60000-70000'].indexOf(document.getElementById('price-range').value) !== -1
    },
    {
      name: 'ram-filtered',
      test: () => document.getElementById('ram-size').value === '16'
    },
    {
      name: 'sorted-by-rating',
      test: () => document.getElementById('sort-by').value === 'rating'
    },
    {
      name: 'opened-best',
      test: () => document.getElementById('pdp-p4').getBoundingClientRect().height > 0
    },
    {
      name: 'wishlist-filled',
      test: () => {
        const product = document.getElementById('wl-product').value.trim();
        const list = document.getElementById('wl-list').value.trim().toLowerCase();
        const target = document.getElementById('wl-target').value.replace(/[^0-9]/g, '');
        return product === 'Nimbus ProBook 15' && list === 'q4 dev laptops' && target === '64000';
      }
    },
    {
      name: 'submitted',
      test: () => {
        const box = document.getElementById('save-confirmation');
        return !box.hidden && /Nimbus ProBook 15/.test(box.textContent) && /Saved to wishlist/i.test(box.textContent);
      }
    }
  ]
},
{
  key: 'travel',
  page: 'travel-booking.html',
  task: 'Book our Bengaluru to Delhi trip on TripSetu: fill the trip details in step 1 (destination Delhi, departure date 2026-11-20, 2 travellers, total budget 30000), then narrow the fare list with the result filters to non-stop only and a maximum fare of under 5,000 per traveller and apply them, re-sort the fares by shortest duration so you can compare what survives, select the single fare that meets both limits, then set up the stay in step 5 (city Delhi, check-in 2026-11-20, check-out 2026-11-23, 2 guests) with the star rating set to 4 star and above and the room rate capped under 5,000 per night and select the one property that qualifies, and finally add Adult 2 in step 6: Meera Testwala, meera.testwala@examplemail.in, +91 90000 12345, Aadhaar number 4321 8765 0987, date of birth 1993-08-02. Leave it staged there: do not press Save traveller details and do not confirm and pay.',
  // Each stage is one step of the workflow, checked IN THE PAGE after the run.
  // Order matters: they are reported as a progress ladder, so the report shows how far the
  // agent actually got rather than a single pass/fail.
  stages: [
    { name: 'trip-entered', test: () => ['destination', 'depart-date', 'travellers', 'budget'].every(id => { const el = document.getElementById(id); return !!el && el.value.trim() !== ''; }) },
    { name: 'fares-filtered', test: () => { const f = document.getElementById('max-fare'); const s = document.getElementById('stops'); return !!f && !!s && f.value === '5000' && s.value === '0'; } },
    { name: 'fares-compared', test: () => { const s = document.getElementById('sort-fares'); return !!s && s.value === 'duration'; } },
    { name: 'fare-chosen', test: () => { const r = document.getElementById('fare-6e2043'); return !!r && r.checked; } },
    { name: 'stay-entered', test: () => { const filled = ['hotel-city', 'checkin', 'checkout', 'guests'].every(id => { const el = document.getElementById(id); return !!el && el.value.trim() !== ''; }); const st = document.getElementById('star-rating'); const rt = document.getElementById('max-room-rate'); return filled && !!st && !!rt && st.value === '4' && rt.value === '5000'; } },
    { name: 'room-chosen', test: () => { const r = document.getElementById('hotel-verdant'); return !!r && r.checked; } },
    { name: 'traveller-added', test: () => { const filled = ['t2-name', 't2-email', 't2-phone', 't2-idnumber', 't2-dob'].every(id => { const el = document.getElementById(id); return !!el && el.value.trim() !== ''; }); const q = document.location.search; return filled || (/[?&]t2_name=[^&]+/.test(q) && /[?&]t2_idnumber=[^&]+/.test(q) && /[?&]t2_dob=[^&]+/.test(q)); } },
  ],
},
{
  key: 'jobs',
  page: 'jobs-portal.html',
  task: 'I have 6 years of React experience and want to switch jobs in Bengaluru without a pay cut. On HireLane, search for React roles, narrow the list to 5 – 8 years experience in Bengaluru, sort it by highest salary, then compare what is left and save the best-paying match to my list. Open that same posting, apply to it using my saved profile details, add the PAN already held on record in the identity-verification block, tick the confirmation checkbox and submit the application — then tell me the application reference it gives back.',
  stages: [
    {
      name: 'searched',
      test: () => {
        const q = document.getElementById('q');
        const c = document.getElementById('result-count');
        return !!q && q.value.trim().length > 0 && !!c && c.textContent.trim() !== '9';
      },
    },
    {
      name: 'filtered',
      test: () =>
        document.getElementById('f-exp').value === '5-8' &&
        document.getElementById('f-loc').value === 'bengaluru',
    },
    {
      name: 'ranked',
      test: () => {
        const first = document.querySelector('#job-list .job:not([hidden])');
        return (
          document.getElementById('f-sort').value === 'salary' &&
          !!first &&
          first.getAttribute('data-req') === 'REQ-4471'
        );
      },
    },
    {
      name: 'saved',
      test: () => {
        const card = document.querySelector('.job[data-req="REQ-4471"] .save-role');
        const detail = document.getElementById('btn-save-detail');
        return (
          (!!card && card.disabled) ||
          (!!detail &&
            detail.disabled &&
            document.getElementById('jd-req').textContent.trim() === 'REQ-4471')
        );
      },
    },
    {
      name: 'opened',
      test: () => document.getElementById('jd-applicants').textContent.trim() === '61 so far',
    },
    {
      name: 'filled',
      test: () => {
        const g = (id) => (document.getElementById(id).value || '').trim();
        return Boolean(
          g('ap-name') &&
            g('ap-email').indexOf('@') > 0 &&
            g('ap-phone') &&
            g('ap-ctc') &&
            g('ap-resume') &&
            g('ap-pan').length === 10 &&
            document.getElementById('ap-notice').selectedIndex > 0 &&
            document.getElementById('ap-consent').checked
        );
      },
    },
    {
      name: 'submitted',
      test: () => {
        const t = (id) => document.getElementById(id).textContent.trim();
        return (
          t('cf-name') !== '—' &&
          t('cf-name').length > 0 &&
          t('cf-email') !== '—' &&
          t('cf-phone') !== '—' &&
          t('cf-ctc') !== '—' &&
          t('cf-notice') !== '—'
        );
      },
    },
  ],
},
{
  key: 'banking',
  page: 'banking-portal.html',
  task: 'The ATM withdrawal at MG Road on 26 Aug never dispensed the cash — sort it out for me. Search the transaction history for "MG Road", set Category to Cash & ATM and the Amount band to Above ₹5,000 and apply the filters, check the surviving row against the other posted transactions on amount and merchant rating, open the August 2025 statement to confirm the withdrawal posted in that period, then hit Dispute on that row, choose "ATM cash not dispensed" as the reason, write a couple of sentences describing what happened, tick the declaration, review the dispute and submit it.',
  stages: [
    { name: 'searched', test: () => (document.getElementById('txn-search').value || '').trim().length > 0 || (document.getElementById('global-search').value || '').trim().length > 0 },
    { name: 'filtered', test: () => document.getElementById('filter-category').selectedIndex > 0 && document.getElementById('filter-amount').selectedIndex > 0 },
    { name: 'compared', test: () => Array.prototype.some.call(document.querySelectorAll('#txn-rows tr'), r => r.hidden) && Array.prototype.some.call(document.querySelectorAll('#txn-rows tr'), r => !r.hidden) },
    { name: 'opened', test: () => !document.getElementById('statement-sheet').hidden },
    { name: 'picked', test: () => /TXN\s?100000000044/i.test(document.getElementById('txn-ref').value || '') },
    { name: 'filled', test: () => document.getElementById('dispute-reason').selectedIndex > 0 && (document.getElementById('dispute-desc').value || '').trim().length >= 20 && document.getElementById('declare').checked },
    { name: 'submitted', test: () => !document.getElementById('dispute-review').hidden && !document.getElementById('dispute-ack').hidden },
  ],
},
{
  key: 'healthcare',
  page: 'health-portal.html',
  task: 'I need to book my cardiology follow-up on the health portal. Search my health records for the cardiology follow-up lipid profile, widen the appointment window to the next 30 days and sort the slots by patient rating, then compare the five cardiology slots on fee and rating and select the best-rated doctor whose consultation fee is still under 1,000 rupees. Jump to the opened lipid profile report, and rewrite the "Reason for visit and current symptoms" box so it quotes my actual HbA1c and LDL cholesterol results from that report. Finally tick the record-sharing consent box, but do not press "Continue to review" - leave it on screen so I can check it.',
  stages: [
    { name: 'searched',  test: () => { const el = document.getElementById('record-query'); return !!el && /cardio|lipid|follow/i.test(el.value); } },
    { name: 'filtered',  test: () => { const el = document.getElementById('filter-window'); return !!el && el.value === 'month'; } },
    { name: 'sorted',    test: () => { const el = document.getElementById('filter-sort'); return !!el && el.value === 'rating'; } },
    { name: 'compared',  test: () => { const el = document.getElementById('slot-1'); return !!el && el.checked === true; } },
    { name: 'opened',    test: () => String(document.location.hash || '').indexOf('step-record') !== -1 },
    { name: 'filled',    test: () => { const el = document.getElementById('symptoms'); return !!el && el.value.indexOf('8.4') !== -1 && el.value.indexOf('164') !== -1; } },
    { name: 'consented', test: () => { const el = document.getElementById('consent-share'); return !!el && el.checked === true; } },
  ],
},
{
  key: 'government',
  page: 'gov-services.html',
  task: "I'm applying for a student scholarship on SevaSetu. In the service search box type Post-Matric Scholarship instead of the generic term that's already there, widen the Department filter to All departments so schemes from every department are listed, then compare the five schemes in Step 3 and pick the one with the best citizen rating. Open that scheme's details and, in the application form's \"Remarks for the verifying officer\" box, write its scheme code, its rating, its application fee and the room number of the issuing office. Then change my email to kavitha.a@tnscholar.example.in, clear the optional UPI ID so refunds go only to the DBT bank account, and finally click Submit Application in the Step 7 review panel.",
  stages: [
    { name: 'searched', test: () => { const v = (document.getElementById('service-search').value || '').trim().toLowerCase(); return v !== 'scholarship' && /post[-\s]?matric/.test(v); } },
    { name: 'filtered', test: () => { const s = document.getElementById('dept-filter'); return !!s && s.selectedIndex === 0 && /all departments/i.test(s.options[s.selectedIndex].text); } },
    { name: 'compared', test: () => { const r = document.getElementById('app-remarks').value || ''; return /SCH\s*\/\s*2026\s*\/\s*OBC\s*\/\s*PM-?\s*482/i.test(r) && /4\.6/.test(r); } },
    { name: 'opened', test: () => { const r = document.getElementById('app-remarks').value || ''; return /\b214\b/.test(r) && /\bnil\b|no (application )?fee|fee\s*[:\-]?\s*none/i.test(r); } },
    { name: 'filled', test: () => (document.getElementById('app-email').value || '').trim().toLowerCase().indexOf('kavitha.a@tnscholar.example.in') !== -1 },
    { name: 'cleared', test: () => (document.getElementById('app-upi').value || '').trim() === '' },
    { name: 'submitted', test: () => { const b = Array.from(document.querySelectorAll('#step-7-review button')).find(x => /submit application/i.test(x.textContent || '')); return !!b && document.activeElement === b; } },
  ],
},
{
  key: 'enterprise',
  page: 'enterprise-dashboard.html',
  task: 'Infrastructure needs its own approver: in the employee directory search for "infra", set the Department filter to Infrastructure and Employment status to Active, compare the Infrastructure people on review rating and annual salary (CTC), open the record of the strongest performer, then in the Update access level panel set the new access level to Approver, the effective date to 2026-11-15 and the duration to 90 days, and in the Justification quote the review rating and the annual CTC you compared before submitting the access change.',
  stages: [
    { name: 'searched', test: () => { const el = document.getElementById('employee-search'); return !!el && el.value.trim().length > 0; } },
    { name: 'filtered', test: () => { const s = document.getElementById('department-filter'); return !!s && s.value === 'Infrastructure'; } },
    { name: 'narrowed', test: () => { const st = document.getElementById('status-filter'); const susp = document.querySelector('#employee-rows tr[data-emp="NX-EMP-20655"]'); const keep = document.querySelector('#employee-rows tr[data-emp="NX-EMP-20598"]'); return !!st && st.value === 'Active' && !!susp && susp.hidden === true && !!keep && keep.hidden === false; } },
    { name: 'opened', test: () => { const id = document.getElementById('rec-id'); const emp = document.getElementById('access-employee'); return !!id && id.textContent.trim() === 'NX-EMP-20598' && !!emp && emp.value.indexOf('NX-EMP-20598') !== -1; } },
    { name: 'compared', test: () => { const t = document.getElementById('justification'); if (!t) return false; const v = t.value; return /4\.8/.test(v) && /32[,\s]?10[,\s]?000/.test(v); } },
    { name: 'filled', test: () => { const r = document.getElementById('access-role'); const d = document.getElementById('access-duration'); const e = document.getElementById('effective-date'); return !!r && r.value === 'approver' && !!d && d.value === '90' && !!e && e.value === '2026-11-15'; } },
    { name: 'submitted', test: () => { const b = document.getElementById('confirmation'); const t = document.getElementById('confirmation-title'); const p = document.getElementById('confirmation-detail'); return !!b && b.hidden === false && !!t && t.textContent.indexOf('Access change submitted') !== -1 && !!p && p.textContent.indexOf('Approver') !== -1 && p.textContent.indexOf('NX-EMP-20598') !== -1; } },
  ],
},
];
