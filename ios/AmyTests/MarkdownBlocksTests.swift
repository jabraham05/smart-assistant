import Testing
@testable import Amy

@Suite struct MarkdownBlocksTests {
    @Test func headingsParagraphsAndBullets() {
        let md = """
        # Title
        First line
        continues here.

        ## Section
        - one
        - two
        """
        #expect(MarkdownBlocks.parse(md) == [
            .heading(1, "Title"),
            .paragraph("First line continues here."),
            .heading(2, "Section"),
            .bullet("one"),
            .bullet("two"),
        ])
    }

    @Test func frontmatterIsDropped() {
        let md = """
        ---
        name: x
        ---
        Body
        """
        #expect(MarkdownBlocks.parse(md) == [.paragraph("Body")])
    }

    @Test func codeFencesStayVerbatim() {
        let md = "```\nlet a = 1\n# not a heading\n```"
        #expect(MarkdownBlocks.parse(md) == [.code("let a = 1\n# not a heading")])
    }

    @Test func hashtagWithoutSpaceIsNotAHeading() {
        #expect(MarkdownBlocks.parse("#hashtag text") == [.paragraph("#hashtag text")])
    }

    @Test func statusLabelsReadAsPlainLanguage() {
        #expect(StatusStyle.of("needs_review_failed").label == "Needs attention")
        #expect(StatusStyle.of("proposed").label == "Awaiting review")
        #expect(StatusStyle.of("some_new_state").label == "Some new state")
    }
}
