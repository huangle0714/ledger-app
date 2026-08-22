import SwiftData
import SwiftUI

struct ContentView: View {
    @State private var selection = 0

    var body: some View {
        TabView(selection: $selection) {
            OverviewView(selection: $selection).tabItem { Label("总览", systemImage: "house") }.tag(0)
            CardsView().tabItem { Label("卡片", systemImage: "rectangle.grid.1x2") }.tag(1)
            RepaymentView().tabItem { Label("还款", systemImage: "checkmark.circle") }.tag(2)
            SettingsView().tabItem { Label("设置", systemImage: "gearshape") }.tag(3)
        }
        .tint(Color(hex: "3977EE"))
    }
}

struct OverviewView: View {
    @Binding var selection: Int
    @Query(sort: \CardAccount.dueDay) private var cards: [CardAccount]

    private var totalLimit: Double { cards.reduce(0) { $0 + $1.creditLimit } }
    private var usedAmount: Double { cards.reduce(0) { $0 + $1.usedAmount } }
    private var usage: Double { totalLimit > 0 ? usedAmount / totalLimit : 0 }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    summary
                    sectionTitle("未来 30 天", title: "待还款", action: "查看全部") { selection = 2 }
                    Button { selection = 2 } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "exclamationmark").font(.headline).foregroundStyle(.orange).frame(width: 34, height: 34).background(Color.orange.opacity(0.13), in: RoundedRectangle(cornerRadius: 10))
                            VStack(alignment: .leading, spacing: 4) { Text("3 笔账单即将到期").font(.subheadline.bold()); Text("最近还款日 · 2026-08-23").font(.caption).foregroundStyle(.secondary) }
                            Spacer(); Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }.padding(14).background(.background, in: RoundedRectangle(cornerRadius: 16))
                    }.buttonStyle(.plain)
                    sectionTitle("已绑定账户", title: "我的卡片", action: "添加") { }
                    ForEach(cards.prefix(4)) { card in CardRow(card: card) }
                }.padding(.horizontal, 18).padding(.top, 12).padding(.bottom, 20)
            }
            .navigationTitle("总览")
            .navigationBarTitleDisplayMode(.large)
        }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text("账户总览").font(.subheadline).foregroundStyle(.white.opacity(0.75)); Spacer(); Image(systemName: "arrow.clockwise").foregroundStyle(.white.opacity(0.8)) }
            HStack(alignment: .lastTextBaseline) { Text(totalLimit.moneyText).font(.system(size: 30, weight: .bold)); Text("总额度").font(.caption).foregroundStyle(.white.opacity(0.7)) }
            ProgressView(value: usage).tint(Color(hex: "64D6BA"))
            HStack { Text("已用 \(usedAmount.moneyText)"); Spacer(); Text("\(Int(usage * 100))%") }.font(.caption).foregroundStyle(.white.opacity(0.76))
            HStack {
                metric("固定额度", totalLimit.moneyText); Spacer(); metric("临时额度", "¥0"); Spacer(); metric("可用额度", (totalLimit - usedAmount).moneyText)
            }.padding(.top, 4).overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.15)).frame(height: 1) }
        }.padding(20).foregroundStyle(.white).background(LinearGradient(colors: [Color(hex: "203451"), Color(hex: "28466C")], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 22))
    }

    private func metric(_ label: String, _ value: String) -> some View { VStack(alignment: .leading, spacing: 4) { Text(label).font(.caption2).foregroundStyle(.white.opacity(0.65)); Text(value).font(.caption.bold()) } }
    private func sectionTitle(_ eyebrow: String, title: String, action: String, actionHandler: @escaping () -> Void) -> some View { HStack(alignment: .bottom) { VStack(alignment: .leading, spacing: 4) { Text(eyebrow.uppercased()).font(.caption2.bold()).foregroundStyle(.secondary); Text(title).font(.title3.bold()) }; Spacer(); Button(action, action: actionHandler).font(.caption.bold()) } }
}

struct CardsView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \CardAccount.dueDay) private var cards: [CardAccount]
    @State private var search = ""
    @State private var showAdd = false
    @State private var filter = 0

    private var visibleCards: [CardAccount] { cards.filter { card in let matchesSearch = search.isEmpty || "\(card.bankName)\(card.shortName)\(card.lastFour)".localizedCaseInsensitiveContains(search); let matchesFilter = filter == 0 || (filter == 1 && card.isUrgent) || (filter == 2 && card.availableAmount > 0); return matchesSearch && matchesFilter } }

    var body: some View {
        NavigationStack {
            List {
                Picker("筛选", selection: $filter) { Text("全部").tag(0); Text("即将还款").tag(1); Text("有可用额度").tag(2) }.pickerStyle(.segmented).listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0)).listRowBackground(Color.clear)
                Section("\(visibleCards.count) 张卡片") { ForEach(visibleCards) { card in NavigationLink { CardDetailView(card: card) } label: { CardRow(card: card) } }.onDelete { offsets in delete(offsets) } }
            }.listStyle(.insetGrouped).searchable(text: $search, prompt: "搜索银行、卡号后四位").navigationTitle("我的卡片").toolbar { ToolbarItem(placement: .topBarTrailing) { Button { showAdd = true } label: { Image(systemName: "plus") } } }.sheet(isPresented: $showAdd) { AddCardView() }
        }
    }

    private func delete(_ offsets: IndexSet) { offsets.map { visibleCards[$0] }.forEach(modelContext.delete) }
}

struct CardRow: View {
    let card: CardAccount
    var body: some View { HStack(spacing: 12) { Text(card.shortName).font(.caption.bold()).foregroundStyle(.white).frame(width: 40, height: 40).background(Color(hex: card.colorHex), in: RoundedRectangle(cornerRadius: 12)); VStack(alignment: .leading, spacing: 4) { Text(card.bankName).font(.subheadline.bold()); Text("信用卡 · 尾号 \(card.lastFour)").font(.caption).foregroundStyle(.secondary) }; Spacer(); VStack(alignment: .trailing, spacing: 4) { Text(card.usedAmount.moneyText).font(.subheadline.bold()); Text("\(card.dueText) · \(card.status)").font(.caption2).foregroundStyle(card.isUrgent ? .orange : .green) }; Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }.padding(.vertical, 4) }
}

struct CardDetailView: View {
    @Bindable var card: CardAccount
    var body: some View { ScrollView { VStack(alignment: .leading, spacing: 18) { HStack(spacing: 12) { Text(card.shortName).font(.headline).foregroundStyle(.white).frame(width: 48, height: 48).background(Color(hex: card.colorHex), in: RoundedRectangle(cornerRadius: 15)); VStack(alignment: .leading, spacing: 4) { Text(card.bankName).font(.headline); Text("信用卡 · 尾号 \(card.lastFour)").font(.caption).foregroundStyle(.secondary) } }; Text(card.usedAmount.moneyText).font(.system(size: 30, weight: .bold)); Text("当前已用额度").font(.caption).foregroundStyle(.secondary); ProgressView(value: card.usageRatio).tint(Color(hex: "3977EE")); HStack { detailCell("总额度", card.creditLimit.moneyText); detailCell("可用额度", card.availableAmount.moneyText) }; detailRow("账单日", "每月 \(card.dueDay)日"); detailRow("还款日", card.dueText) }.padding(20) }.navigationTitle("卡片详情").navigationBarTitleDisplayMode(.inline) }
    private func detailCell(_ title: String, _ value: String) -> some View { VStack(alignment: .leading, spacing: 6) { Text(title).font(.caption).foregroundStyle(.secondary); Text(value).font(.subheadline.bold()) }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12)) }
    private func detailRow(_ title: String, _ value: String) -> some View { HStack { Text(title).foregroundStyle(.secondary); Spacer(); Text(value).bold() }.font(.subheadline).padding(.vertical, 10).overlay(alignment: .top) { Rectangle().fill(Color(uiColor: .separator)).frame(height: 0.5) } }
}

struct AddCardView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @State private var bank = ""
    @State private var lastFour = ""
    @State private var limit = ""
    @State private var dueDay = "1"
    var body: some View { NavigationStack { Form { Section("卡片信息") { TextField("发卡银行", text: $bank); TextField("卡号后四位", text: $lastFour).keyboardType(.numberPad); TextField("总额度", text: $limit).keyboardType(.decimalPad); TextField("还款日", text: $dueDay).keyboardType(.numberPad) } }.navigationTitle("添加卡片").toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("保存") { save() }.disabled(bank.isEmpty || lastFour.count != 4) } } } }
    private func save() { modelContext.insert(CardAccount(bankName: bank, shortName: String(bank.prefix(2)), lastFour: lastFour, creditLimit: Double(limit) ?? 0, usedAmount: 0, dueDay: Int(dueDay) ?? 1, status: "未还款", colorHex: "3977EE", isUrgent: false)); dismiss() }
}

struct RepaymentView: View {
    @Query(filter: #Predicate<CardAccount> { $0.isUrgent }, sort: \CardAccount.dueDay) private var cards: [CardAccount]
    var body: some View { NavigationStack { List { Section { HStack { ForEach([18,19,20,21,22,23,24], id: \.self) { day in VStack(spacing: 5) { Text(day == 21 ? "今天" : "周").font(.caption2).foregroundStyle(.secondary); Text("\(day)").font(.headline).foregroundStyle(day == 22 ? .white : .primary).frame(maxWidth: .infinity).padding(.vertical, 8).background(day == 22 ? Color(hex: "3977EE") : .clear, in: RoundedRectangle(cornerRadius: 10)) } } } }.listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0)).listRowBackground(Color.clear); Section("共 \(cards.count) 笔 · 即将到期") { ForEach(cards) { card in VStack(alignment: .leading, spacing: 10) { HStack { Text("\(card.dueText) · \(card.bankName)").font(.subheadline.bold()); Spacer(); Text("待还款").font(.caption).foregroundStyle(.orange) }; HStack { Text("尾号 \(card.lastFour)").font(.caption).foregroundStyle(.secondary); Spacer(); Text(card.usedAmount.moneyText).font(.headline) }; Text("预计最低还款 \((card.usedAmount * 0.1).moneyText)").font(.caption).foregroundStyle(.secondary) }.padding(.vertical, 5) } } }.listStyle(.insetGrouped).navigationTitle("还款") } }
}

struct SettingsView: View {
    @AppStorage("remindersEnabled") private var remindersEnabled = true
    var body: some View { NavigationStack { Form { Section("数据与提醒") { Toggle("自动同步账单", isOn: .constant(false)).disabled(true); Toggle("还款提醒", isOn: $remindersEnabled); HStack { Text("数据存储"); Spacer(); Text("仅本机").foregroundStyle(.secondary) } } }.navigationTitle("设置") } }
}
