// planner-tutor-context.test.js — test for planner-tutor-context.js
import { plannerTutorContextModel, plannerTutorSourcesText, plannerTutorCopyStatusModel } from '../planner-tutor-context.js';

test('plannerTutorContextModel returns correct structure', () => {
  const assignment = {
    title: 'Test Assignment',
    courseName: 'Test Course',
    materials: [{ title: 'Material 1' }, { title: 'Material 2' }]
  };
  const context = plannerTutorContextModel(assignment);
  expect(context).toHaveProperty('badge');
  expect(context).toHaveProperty('summary');
  expect(context).toHaveProperty('sources');
  expect(context.badge).toBe('Grounded in this assignment');
  expect(context.summary).toBe('Test Assignment · Test Course · 2 attached materials');
  expect(context.sources).toEqual(['Test Assignment', { title: 'Material 1' }, { title: 'Material 2' }].map(m => String(m?.title || 'Attached material').trim()));
});

test('plannerTutorSourcesText returns formatted string', () => {
  const assignment = {
    title: 'Test Assignment',
    courseName: 'Test Course',
    materials: [{ title: 'Material 1' }]
  };
  const text = plannerTutorSourcesText(assignment);
  expect(text).toContain('Grounded in this assignment');
  expect(text).toContain('Test Assignment · Test Course · 1 attached material');
  expect(text).toContain('Sources: Test Assignment · Material 1');
});

test('plannerTutorCopyStatusModel returns correct status', () => {
  expect(plannerTutorCopyStatusModel('idle')).toEqual({ label: 'Copy sources', announcement: '' });
  expect(plannerTutorCopyStatusModel('success')).toEqual({ label: 'Copied', announcement: 'Grounding sources copied' });
  expect(plannerTutorCopyStatusModel('error')).toEqual({ label: 'Copy failed', announcement: 'Could not copy grounding sources' });
});