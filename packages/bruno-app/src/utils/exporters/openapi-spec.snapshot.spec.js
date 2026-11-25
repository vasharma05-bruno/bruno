import { exportApiSpec, serializeOpenApiSpec } from './openapi-spec';
import { buildRequests, collectionVariables, envVariables } from './__fixtures__/api-spec-collection';

// Uses the real @usebruno/common interpolate (no mock) and calls the exporter the way CreateApiSpec does
const exportForEnvironment = (requests, environment) => {
  const { spec, warnings } = exportApiSpec('Api Spec Fixture', requests, collectionVariables, envVariables, environment);

  return { content: serializeOpenApiSpec(spec, 'yaml'), warnings };
};

// An xml parse error message carries the parser's stack trace, whose frames name absolute paths on this machine,
// jest internals and the exporter's own function names. Drop just those frames so the snapshot is machine
// independent and survives a refactor that only renames internal functions.
const withoutStackFrames = (warnings) => warnings.map((warning) => ({
  ...warning,
  message: warning.message.replace(/\n\s+at .*/g, '')
}));

describe('exportApiSpec snapshot', () => {
  describe.each([['bru'], ['yml']])('a %s collection', (format) => {
    it.each([
      ['no environment', ''],
      ['the Local environment', 'Local'],
      ['the Prod environment', 'Prod']
    ])('exports the fixture collection with %s', (_label, environment) => {
      const { content, warnings } = exportForEnvironment(buildRequests(format), environment);

      expect(content).toMatchSnapshot('content');
      expect(withoutStackFrames(warnings)).toMatchSnapshot('warnings');
    });
  });
});
