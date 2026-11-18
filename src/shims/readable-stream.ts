// jszip's lib/ sources ask for Node streams only to offer generateNodeStream(), which Docxwise never
// calls. Its prebuilt browser file had no stream module either, so support.nodestream stays false.
export {};
