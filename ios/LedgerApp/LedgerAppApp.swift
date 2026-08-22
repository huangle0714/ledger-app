import SwiftData
import SwiftUI

@main
struct LedgerAppApp: App {
    let container: ModelContainer

    init() {
        let schema = Schema([CardAccount.self])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)
        do {
            container = try ModelContainer(for: schema, configurations: [configuration])
        } catch {
            fatalError("Unable to create local data store: \(error)")
        }

        let context = container.mainContext
        let existing = (try? context.fetch(FetchDescriptor<CardAccount>())) ?? []
        if existing.isEmpty {
            SampleData.cards.forEach(context.insert)
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(container)
    }
}
