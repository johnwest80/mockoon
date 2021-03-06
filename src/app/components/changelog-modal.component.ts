import { HttpClient } from '@angular/common/http';
import { AfterViewInit, Component, ElementRef, EventEmitter, OnInit, Output, ViewChild } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { shell } from 'electron';
import { Config } from 'src/app/config';
import { AnalyticsEvents } from 'src/app/enums/analytics-events.enum';
import { EventsService } from 'src/app/services/events.service';
const appVersion = require('../../../package.json').version;

@Component({
  selector: 'app-changelog-modal',
  templateUrl: './changelog-modal.component.html'
})
export class ChangelogModalComponent implements OnInit, AfterViewInit {
  @ViewChild('modal', { static: false }) modal: ElementRef;
  @Output() closed: EventEmitter<any> = new EventEmitter();
  public appVersion = appVersion;
  public releaseChangelog: string;

  constructor(private modalService: NgbModal, private eventsService: EventsService, private httpClient: HttpClient) {
    this.httpClient.get(Config.githubAPITagReleaseUrl + appVersion).subscribe((release) => {
      this.releaseChangelog = release['body'];
    });
  }

  ngOnInit() { }

  ngAfterViewInit() {
    this.eventsService.changelogModalEvents.subscribe(() => {
      this.modalService.open(this.modal, { backdrop: 'static', centered: true }).result.then(() => {
        this.closed.emit();
      }, () => { });
    });
  }

  public openReleaseLink() {
    shell.openExternal(Config.githubTagReleaseUrl + appVersion);

    this.eventsService.analyticsEvents.next(AnalyticsEvents.LINK_RELEASE);
  }
}
