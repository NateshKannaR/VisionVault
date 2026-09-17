const assert = require("assert");
const TaskChecklist = require("../extension/planner/task-checklist.js");
const VisualGrounding = require("../extension/planner/visual-grounding.js");
const TaskPlanner = require("../extension/task-planner.js");
const RegionMerger = require("../extension/vision/region-merger.js");

console.log("Testing TaskChecklist & VisualGrounding...");

// 1. TaskChecklist generation
const parsed1 = TaskPlanner.parseTask("open amazon and search for wireless headphones then select first result");
const list1 = TaskChecklist.generateTaskChecklist("open amazon and search for wireless headphones then select first result", parsed1);

assert(Array.isArray(list1), "Checklist should be an array");
assert(list1.length >= 3, "Checklist should contain multiple milestones");
assert.strictEqual(list1[0].id, "navigate");
assert.strictEqual(list1[0].status, "in_progress");
console.log("  ok   TaskChecklist generates structured milestones");

// 2. TaskChecklist updates
const updated1 = TaskChecklist.updateChecklist(list1, { action: "navigate", url: "https://www.amazon.in" }, { progress: { navigated: true } });
assert.strictEqual(updated1[0].status, "done");
assert.strictEqual(updated1[1].status, "in_progress");
console.log("  ok   TaskChecklist marks completed steps and advances in_progress milestone");

// 3. VisualGrounding: Candidate proposal
const mockMarks = [
  { id: 1, tag: "input", type: "text", label: "Search Amazon.in", box: { x: 100, y: 50, width: 400, height: 40 } },
  { id: 2, tag: "button", label: "Go", box: { x: 510, y: 50, width: 40, height: 40 } },
  { id: 3, tag: "a", label: "Today's Deals", box: { x: 100, y: 120, width: 100, height: 20 } },
  { id: 4, tag: "a", label: "boAt Rockerz 450 Wireless Headphones", box: { x: 200, y: 300, width: 300, height: 80 } }
];

const parsedSearch = TaskPlanner.parseTask("search for wireless headphones");
const searchCandidates = VisualGrounding.proposeGroundedCandidates(mockMarks, parsedSearch);
assert(searchCandidates.length > 0, "Should propose candidates for search");
assert.strictEqual(searchCandidates[0].mark_id, 1, "Top candidate for search should be input #1");
console.log("  ok   VisualGrounding prioritizes search input for search queries");

const parsedProduct = TaskPlanner.parseTask("select boAt Rockerz 450");
const productCandidates = VisualGrounding.proposeGroundedCandidates(mockMarks, parsedProduct);
assert(productCandidates.length > 0, "Should propose candidates for selection");
assert.strictEqual(productCandidates[0].mark_id, 4, "Top candidate for product selection should be link #4");
console.log("  ok   VisualGrounding semantic matching identifies target product");

// 4. RegionMerger test
const domRegions = [{ x: 10, y: 10, w: 100, h: 30, type: "pii", label: "username" }];
const ocrRegions = [{ x: 12, y: 11, w: 98, h: 28, type: "pii", source: "vision_ocr", text: "natesh" }];
const merged = RegionMerger.mergeRegions(domRegions, [], ocrRegions);
assert.strictEqual(merged.length, 1, "Overlapping DOM and OCR regions should be merged into 1");
assert.strictEqual(merged[0].sources.length, 2, "Merged region should preserve both sources");
console.log("  ok   RegionMerger deduplicates and merges multi-modal regions");

console.log("\n🎉 ALL CHECKLIST, GROUNDING & REGION MERGER TESTS PASSED!");
